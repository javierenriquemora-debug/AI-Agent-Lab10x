import { NextResponse } from "next/server";
import { createServerClient, revokeIntegration } from "@agents/db";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = createServerClient();
    await revokeIntegration(db, user.id, "github");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("GitHub disconnect failed:", error);
    return NextResponse.json({ error: "Failed to disconnect GitHub" }, { status: 500 });
  }
}
