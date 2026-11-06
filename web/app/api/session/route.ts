import { proxy } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => proxy(req, "/session");
