import { redirect } from "next/navigation";

import { desktopRoute } from "@/lib/routes";

export default function ReviewRedirect() {
  redirect(desktopRoute("review-queue"));
}
