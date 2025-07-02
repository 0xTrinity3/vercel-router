export const config = {
  runtime: 'edge',
};

// IMPORTANT: These environment variables must be set in your Vercel project settings.
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

export default async function handler(request: Request) {
  const url = new URL(request.url);
    const pathSegments = url.pathname.slice(1).split('/').filter(Boolean);
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

    const agentResponse = await fetch(targetUrl.toString(), {
        headers: request.headers,
        redirect: 'manual',
    });
    
    // 3. Stream the response back to the client
    const response = new Response(agentResponse.body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: agentResponse.headers,
    });
    
    // Clean up Vercel-specific headers
    response.headers.delete('x-vercel-id');

    return response;

  } catch (e) {
    console.error('Router error:', e);
    return new Response('An internal error occurred.', { status: 500 });
  }
}

