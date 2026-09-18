"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DocumentScreen } from "@/components/preview/document-screen";

// The id rides in the query, not the path: the page stays one static shell that
// works offline, and an id is opaque — no document name ever reaches a URL.
function DocumentRoute() {
  const id = useSearchParams().get("id") ?? "";
  return <DocumentScreen key={id} id={id} />;
}

export default function DocumentPage() {
  return (
    <Suspense fallback={null}>
      <DocumentRoute />
    </Suspense>
  );
}
