import { NextResponse } from "next/server";
import { LEVELS } from "@jargon/quiz";

export const dynamic = "force-static";
export const revalidate = 86400;

/** 对外暴露关卡配置（/levels 选关页与进度展示用） */
export async function GET() {
  return NextResponse.json(
    { levels: LEVELS },
    { status: 200, headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } },
  );
}
