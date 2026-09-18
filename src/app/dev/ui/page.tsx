import { notFound } from "next/navigation";
import { Gallery } from "./gallery";

// Dev-only: every Almirah primitive in every variant. Not part of the shipped app.
export default function UiGalleryPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Gallery />;
}
