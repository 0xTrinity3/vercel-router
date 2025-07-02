import { createClient } from '@supabase/supabase-js';

// IMPORTANT: These environment variables must be set in your Vercel project settings.
// You should use the ANON KEY for this, not the service role key.
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  const url = new URL(request.url);
  // The path will be something like '/agent-name-1234'. We remove the leading '/'.
  const slug = url.pathname.slice(1);

  if (!slug) {
    return new Response('Agent slug not specified.', { status: 400 });
  }

  try {
    // 1. Look up the project in Supabase by its slug
    const { data: project, error } = await supabase
      .from('projects')
      .select('preview_url')
      .eq('slug', slug)
      .single();

    if (error || !project || !project.preview_url) {
      console.error('Router: Project slug not found or error fetching from Supabase:', error?.message);
      return new Response(`Agent with slug "${slug}" not found.`, { status: 404 });
    }

    const previewUrl = project.preview_url;

    // 2. Fetch the content from the agent's Vercel deployment URL
    const agentResponse = await fetch(previewUrl + url.pathname + url.search, {
        headers: request.headers,
        redirect: 'manual',
    });
    
    // 3. Stream the response back to the client
    // This creates a new response with the body, status, and headers from the agent's deployment.
    const response = new Response(agentResponse.body, {
        status: agentResponse.status,
        statusText: agentResponse.statusText,
        headers: agentResponse.headers,
    });
    
    // Clean up Vercel-specific headers to avoid conflicts
    response.headers.delete('x-vercel-id');

    return response;

  } catch (e) {
    console.error('Router error:', e);
    return new Response('An internal error occurred.', { status: 500 });
  }
}
