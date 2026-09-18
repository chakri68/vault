"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EditScreen } from "@/components/preview/edit-screen";

function EditRoute() {
  const id = useSearchParams().get("id") ?? "";
  return <EditScreen key={id} id={id} />;
}

export default function EditDocumentPage() {
  return (
    <Suspense fallback={null}>
      <EditRoute />
    </Suspense>
  );
}
