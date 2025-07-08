const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Removed content-encoding and content-length as they can cause issues
];

export const config = {
  runtime: "edge",
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const VERCEL_AUTOMATION_TOKEN = process.env.VERCEL_AUTOMATION_TOKEN;

function extractSlugFromHostname(hostname: string): string | null {
  // Extract the slug from the Vercel hostname
  // Format: agent-quickcart-90c548e8-1751998091905-izo4ya-ck6akdg6x.vercel.app
  // We want: agent-quickcart-90c548e8-1751998091905-izo4ya
  const slugMatch = hostname.match(/^(.+)-([a-z0-9]+)\.vercel\.app$/);

  if (!slugMatch) {
    return null;
  }

  const potentialSlug = slugMatch[1];
  const suffix = slugMatch[2];

  // If the suffix looks like a Vercel-generated ID (alphanumeric, reasonable length)
  // then we use the part before it as the slug
  if (suffix.length >= 6 && suffix.length <= 12 && /^[a-z0-9]+$/.test(suffix)) {
    return potentialSlug;
  }

  return null;
}

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const hostname = url.hostname;

  // Get the path segments
  const pathSegments = url.pathname.slice(1).split("/").filter(Boolean);
  let slug = pathSegments[0];

  // If no slug in path, try to extract from hostname (for direct Vercel deployments)
  if (!slug || slug === "") {
    const extractedSlug = extractSlugFromHostname(hostname);
    if (extractedSlug) {
      console.log(`Router: Extracted slug from hostname: ${extractedSlug}`);
      // Redirect to factory.basedagents.co with the extracted slug
      const targetUrl =
        "https://factory.basedagents.co/" +
        extractedSlug +
        url.pathname +
        url.search;
      return Response.redirect(targetUrl, 302);
    }
  }

  const remainingPath =
    pathSegments.length > 1 ? "/" + pathSegments.slice(1).join("/") : "/";

  // Ignore favicon requests
  if (slug === "favicon.ico" || slug === "favicon.png") {
    return new Response(null, { status: 204 });
  }

  console.log(
    `Router: Received request for slug: "${slug}", remaining path: "${remainingPath}"`
  );

  if (!slug) {
    return new Response("Agent slug not specified.", { status: 400 });
  }

  try {
    // 1. Look up the project in Supabase
    const supabaseUrl = `${SUPABASE_URL}/rest/v1/projects?select=preview_url&slug=eq.${slug}`;
    console.log(`Router: Querying Supabase with URL: ${supabaseUrl}`);

    const supabaseResponse = await fetch(supabaseUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
    });

    if (!supabaseResponse.ok) {
      console.error(
        "Router: Supabase request failed:",
        supabaseResponse.status
      );
      return new Response(`Database error: ${supabaseResponse.status}`, {
        status: 500,
      });
    }

    const projects = await supabaseResponse.json();
    const project = projects?.[0];

    if (!project || !project.preview_url) {
      console.error("Router: Project not found or no preview_url:", projects);

      // FALLBACK: Try to extract slug from hostname and redirect to factory
      const extractedSlug = extractSlugFromHostname(hostname);
      if (extractedSlug) {
        console.log(
          `Router: Falling back to hostname-based redirect for slug: ${extractedSlug}`
        );
        const targetUrl =
          "https://factory.basedagents.co/" +
          extractedSlug +
          url.pathname +
          url.search;
        return Response.redirect(targetUrl, 302);
      }

      return new Response(`Agent with slug "${slug}" not found.`, {
        status: 404,
      });
    }

    const previewUrl = project.preview_url;
    console.log(`Router: Found preview URL: ${previewUrl}`);

    // 2. Construct the target URL properly
    const previewUrlObj = new URL(previewUrl);

    // Preserve existing query parameters from the preview URL (like __VERCEL_PROTECTION_BYPASS)
    const targetUrl = new URL(remainingPath, previewUrlObj.origin);

    // Add original query parameters from preview URL
    previewUrlObj.searchParams.forEach((value, key) => {
      targetUrl.searchParams.set(key, value);
    });

    // Add any query parameters from the incoming request
    url.searchParams.forEach((value, key) => {
      targetUrl.searchParams.set(key, value);
    });

    console.log(`Router: Target URL: ${targetUrl.toString()}`);

    // 3. Prepare headers for the proxy request
    const outboundHeaders = new Headers();

    // Allow more headers that might be needed
    const allowedHeaders = [
      "accept",
      "accept-encoding",
      "accept-language",
      "user-agent",
      "referer",
      "cache-control",
      "pragma",
      "if-none-match",
      "if-modified-since",
    ];

    request.headers.forEach((value, key) => {
      if (allowedHeaders.includes(key.toLowerCase())) {
        outboundHeaders.set(key, value);
      }
    });

    // Add Vercel automation token if available
    if (VERCEL_AUTOMATION_TOKEN) {
      outboundHeaders.set("Authorization", `Bearer ${VERCEL_AUTOMATION_TOKEN}`);
    }

    // 4. Make the proxy request with redirect handling
    let currentUrl = targetUrl.toString();
    let agentResponse;
    let redirectCount = 0;

    while (redirectCount < 3) {
      console.log(`Router: Fetching ${currentUrl} (redirect ${redirectCount})`);

      agentResponse = await fetch(currentUrl, {
        method: request.method,
        headers: outboundHeaders,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
        redirect: "manual",
      });

      console.log(`Router: Response status: ${agentResponse.status}`);

      // If not a redirect, break
      if (![301, 302, 303, 307, 308].includes(agentResponse.status)) {
        break;
      }

      // Follow the redirect
      const location = agentResponse.headers.get("location");
      if (!location) {
        console.error("Router: Redirect without location header");
        break;
      }

      currentUrl = new URL(location, currentUrl).toString();
      redirectCount++;
    }

    // 5. Handle non-200 responses
    if (!agentResponse.ok) {
      const errorBody = await agentResponse.text();
      console.error(
        `Router: Agent returned status ${agentResponse.status}. Body: ${errorBody}`
      );

      return new Response(
        `The agent application returned an error.\n\nStatus: ${agentResponse.status}\nURL: ${currentUrl}\nBody:\n${errorBody}`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // 6. Prepare response headers
    const responseHeaders = new Headers();
    agentResponse.headers.forEach((value, key) => {
      if (!hopByHop.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Always add CORS headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    responseHeaders.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    const contentType = responseHeaders.get("content-type") || "";
    console.log(`Router: Content-Type: ${contentType}`);

    // 7. Handle HTML content with path rewriting
    if (contentType.includes("text/html")) {
      console.log("Router: Processing HTML content");
      let body = await agentResponse.text();

      const pathPrefix = `/${slug}`;

      // More comprehensive path rewriting
      // Handle src, href, action attributes
      body = body.replace(
        /(src|href|action)=(['"])\/((?!\/|https?:\/\/)[^'"]*)\2/gi,
        `$1=$2${pathPrefix}/$3$2`
      );

      // Handle url() in CSS
      body = body.replace(
        /url\((['"]?)\/((?!\/|https?:\/\/)[^'"]*)\1\)/gi,
        `url($1${pathPrefix}/$2$1)`
      );

      // Add base href if not present to help with relative paths
      if (!body.includes("<base")) {
        const baseTag = `<base href="${pathPrefix}/">`;
        body = body.replace(/<head>/i, `<head>\n  ${baseTag}`);
      }

      // Remove content-length since we modified the body
      responseHeaders.delete("content-length");

      console.log("Router: HTML processing complete");

      return new Response(body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: responseHeaders,
      });
    } else {
      // For non-HTML content, stream directly
      return new Response(agentResponse.body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("Router error:", error);
    return new Response(`Internal router error: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

/*const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Removed content-encoding and content-length as they can cause issues
];

export const config = {
  runtime: "edge",
};

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const VERCEL_AUTOMATION_TOKEN = process.env.VERCEL_AUTOMATION_TOKEN;

export default async function handler(request: Request) {
  const url = new URL(request.url);

  // Get the path segments
  const pathSegments = url.pathname.slice(1).split("/").filter(Boolean);
  const slug = pathSegments[0];
  const remainingPath =
    pathSegments.length > 1 ? "/" + pathSegments.slice(1).join("/") : "/";

  // Ignore favicon requests
  if (slug === "favicon.ico" || slug === "favicon.png") {
    return new Response(null, { status: 204 });
  }

  console.log(
    `Router: Received request for slug: "${slug}", remaining path: "${remainingPath}"`
  );

  if (!slug) {
    return new Response("Agent slug not specified.", { status: 400 });
  }

  try {
    // 1. Look up the project in Supabase
    const supabaseUrl = `${SUPABASE_URL}/rest/v1/projects?select=preview_url&slug=eq.${slug}`;
    console.log(`Router: Querying Supabase with URL: ${supabaseUrl}`);

    const supabaseResponse = await fetch(supabaseUrl, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
    });

    if (!supabaseResponse.ok) {
      console.error(
        "Router: Supabase request failed:",
        supabaseResponse.status
      );
      return new Response(`Database error: ${supabaseResponse.status}`, {
        status: 500,
      });
    }

    const projects = await supabaseResponse.json();
    const project = projects?.[0];

    if (!project || !project.preview_url) {
      console.error("Router: Project not found or no preview_url:", projects);
      return new Response(`Agent with slug "${slug}" not found.`, {
        status: 404,
      });
    }

    const previewUrl = project.preview_url;
    console.log(`Router: Found preview URL: ${previewUrl}`);

    // 2. Construct the target URL properly
    const previewUrlObj = new URL(previewUrl);

    // Preserve existing query parameters from the preview URL (like __VERCEL_PROTECTION_BYPASS)
    const targetUrl = new URL(remainingPath, previewUrlObj.origin);

    // Add original query parameters from preview URL
    previewUrlObj.searchParams.forEach((value, key) => {
      targetUrl.searchParams.set(key, value);
    });

    // Add any query parameters from the incoming request
    url.searchParams.forEach((value, key) => {
      targetUrl.searchParams.set(key, value);
    });

    console.log(`Router: Target URL: ${targetUrl.toString()}`);

    // 3. Prepare headers for the proxy request
    const outboundHeaders = new Headers();

    // Allow more headers that might be needed
    const allowedHeaders = [
      "accept",
      "accept-encoding",
      "accept-language",
      "user-agent",
      "referer",
      "cache-control",
      "pragma",
      "if-none-match",
      "if-modified-since",
    ];

    request.headers.forEach((value, key) => {
      if (allowedHeaders.includes(key.toLowerCase())) {
        outboundHeaders.set(key, value);
      }
    });

    // Add Vercel automation token if available
    if (VERCEL_AUTOMATION_TOKEN) {
      outboundHeaders.set("Authorization", `Bearer ${VERCEL_AUTOMATION_TOKEN}`);
    }

    // 4. Make the proxy request with redirect handling
    let currentUrl = targetUrl.toString();
    let agentResponse;
    let redirectCount = 0;

    while (redirectCount < 3) {
      console.log(`Router: Fetching ${currentUrl} (redirect ${redirectCount})`);

      agentResponse = await fetch(currentUrl, {
        method: request.method,
        headers: outboundHeaders,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
        redirect: "manual",
      });

      console.log(`Router: Response status: ${agentResponse.status}`);

      // If not a redirect, break
      if (![301, 302, 303, 307, 308].includes(agentResponse.status)) {
        break;
      }

      // Follow the redirect
      const location = agentResponse.headers.get("location");
      if (!location) {
        console.error("Router: Redirect without location header");
        break;
      }

      currentUrl = new URL(location, currentUrl).toString();
      redirectCount++;
    }

    // 5. Handle non-200 responses
    if (!agentResponse.ok) {
      const errorBody = await agentResponse.text();
      console.error(
        `Router: Agent returned status ${agentResponse.status}. Body: ${errorBody}`
      );

      return new Response(
        `The agent application returned an error.\n\nStatus: ${agentResponse.status}\nURL: ${currentUrl}\nBody:\n${errorBody}`,
        {
          status: 502,
          headers: {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // 6. Prepare response headers
    const responseHeaders = new Headers();
    agentResponse.headers.forEach((value, key) => {
      if (!hopByHop.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Always add CORS headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS"
    );
    responseHeaders.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );

    const contentType = responseHeaders.get("content-type") || "";
    console.log(`Router: Content-Type: ${contentType}`);

    // 7. Handle HTML content with path rewriting
    if (contentType.includes("text/html")) {
      console.log("Router: Processing HTML content");
      let body = await agentResponse.text();

      const pathPrefix = `/${slug}`;

      // More comprehensive path rewriting
      // Handle src, href, action attributes
      body = body.replace(
        /(src|href|action)=(['"])\/((?!\/|https?:\/\/)[^'"]*)\2/gi,
        `$1=$2${pathPrefix}/$3$2`
      );

      // Handle url() in CSS
      body = body.replace(
        /url\((['"]?)\/((?!\/|https?:\/\/)[^'"]*)\1\)/gi,
        `url($1${pathPrefix}/$2$1)`
      );

      // Add base href if not present to help with relative paths
      if (!body.includes("<base")) {
        const baseTag = `<base href="${pathPrefix}/">`;
        body = body.replace(/<head>/i, `<head>\n  ${baseTag}`);
      }

      // Remove content-length since we modified the body
      responseHeaders.delete("content-length");

      console.log("Router: HTML processing complete");

      return new Response(body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: responseHeaders,
      });
    } else {
      // For non-HTML content, stream directly
      return new Response(agentResponse.body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("Router error:", error);
    return new Response(`Internal router error: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}*/
