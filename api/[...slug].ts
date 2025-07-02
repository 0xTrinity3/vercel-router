export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  return new Response('Hello from the edge router!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}
