interface Job { run(): Promise<unknown>; status(): Promise<unknown> }
export default {
  async fetch(request: Request, env: Record<string, Job>) {
    const [binding, action] = new URL(request.url).pathname.slice(1).split("/");
    const job = binding ? env[binding] : undefined;
    if (!job || !["run", "status"].includes(action ?? "")) return new Response("Not found", { status: 404 });
    return Response.json(action === "run" ? await job.run() : await job.status());
  },
};
