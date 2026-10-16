interface Job { run(time?: number): Promise<unknown>; status(): Promise<unknown>; inspect(): Promise<unknown> }
export default {
  async fetch(request: Request, env: Record<string, Job>) {
    const [binding, action] = new URL(request.url).pathname.slice(1).split("/");
    const job = binding ? env[binding] : undefined;
    if (!job || !["run", "status", "inspect"].includes(action ?? "")) return new Response("Not found", { status: 404 });
    const time = new URL(request.url).searchParams.get("time");
    return Response.json(action === "run" ? await (time ? job.run(Number(time)) : job.run())
      : action === "inspect" ? await job.inspect() : await job.status());
  },
};
