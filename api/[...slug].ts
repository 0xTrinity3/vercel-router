export const config = {
  runtime: 'edge',
};

// IMPORTANT: These environment variables must be set in your Vercel project settings.
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

export default async function handler(request: Request) {
  const url = new URL(request.url);

  // Get the original path from the Vercel-specific header.
  // This is more reliable than parsing the rewritten URL's pathname.
  const rewrittenUrl = request.headers.get('x-vercel-rewritten-url') || url.pathname;
  const pathSegments = new URL(rewrittenUrl, url.origin).pathname.slice(1).split('/').filter(Boolean);

  const slug = pathSegments[0];
  const remainingPath = '/' + pathSegments.slice(1).join('/');

  if (!slug) {
    return new Response('Agent slug not specified.', { status: 400 });
  }

  try {
    // 1. Look up the project in Supabase by its slug using the REST API
    const supabaseUrl = `${SUPABASE_URL}/rest/v1/projects?select=preview_url&slug=eq.${slug}`;
    const supabaseResponse = await fetch(supabaseUrl, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept': 'application/json',
      },
    });

    const projects = await supabaseResponse.json();
    const project = projects?.[0];

    if (!supabaseResponse.ok || !project || !project.preview_url) {
      console.error('Router: Project slug not found or error fetching from Supabase:', projects);
      return new Response(`Agent with slug "${slug}" not found.`, { status: 404 });
    }

    const previewUrl = project.preview_url;

    // 2. Fetch the content from the agent's Vercel deployment URL
    // We need to construct the full URL to the resource on the target deployment.
        const targetUrl = new URL(remainingPath + url.search, previewUrl);

    // --- Robust proxy logic ---
    const outboundHeaders = new Headers(request.headers);
    outboundHeaders.delete('host');

    let currentUrl = targetUrl.toString();
    let agentResponse;
    let redirectCount = 0;
    while (redirectCount < 3) {
      agentResponse = await fetch(currentUrl, {
        headers: outboundHeaders,
        redirect: 'manual',
      });
      // Log status and headers
      console.log(`[Proxy] ${currentUrl} -> status: ${agentResponse.status}`);
      agentResponse.headers.forEach((value, key) => {
        console.log(`[Proxy header] ${key}: ${value}`);
      });
      // If not a redirect, break
      if (![301, 302, 303, 307, 308].includes(agentResponse.status)) break;
      // Otherwise, follow the Location header
      const location = agentResponse.headers.get('location');
      if (!location) break;
      currentUrl = new URL(location, currentUrl).toString();
      redirectCount++;
    }
    // Only proxy 200 responses
    if (agentResponse.status !== 200) {
      return new Response(`Router: Agent returned status ${agentResponse.status}`, { status: 502 });
    }
    // Remove hop-by-hop headers
    const hopByHop = [
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'location'
    ];
    const responseHeaders = new Headers();
    agentResponse.headers.forEach((value, key) => {
      if (!hopByHop.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });
    // Stream the response back to the client
    return new Response(agentResponse.body, {
      headers: responseHeaders,
      status: agentResponse.status
    });

  } catch (e) {
    console.error('Router error:', e);
    return new Response('An internal error occurred.', { status: 500 });
  }
}




