import { proxy } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const POST = (req: Request) => proxy(req, "/attempt");
