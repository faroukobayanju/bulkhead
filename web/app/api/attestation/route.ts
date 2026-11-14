import { proxy } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => proxy(req, "/attestation");
