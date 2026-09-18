"use client";

import { Camera, FileUp, Images } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { Group, Row, Sheet, Tile } from "@/components/ui";
import { useFilePicker } from "./file-picker";
import { setPendingFiles } from "./pending-files";

/**
 * Three plain ways to get a document in, as rows. Whatever is picked goes to
 * the review screen by way of memory; nothing is saved until "Save to vault".
 */
export function AddSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();

  const review = useCallback((files: File[]) => {
    setPendingFiles(files);
    onOpenChange(false);
    router.push("/add");
  }, [onOpenChange, router]);

  const camera = useFilePicker({ label: "Take a photo", accept: "image/*", capture: "environment", onFiles: review });
  const photos = useFilePicker({ label: "Choose from photos", accept: "image/*", multiple: true, onFiles: review });
  const files = useFilePicker({ label: "Choose a file", multiple: true, onFiles: review });

  return (
    <>
      {/* outside the sheet, so they're still mounted when the OS picker hands control back */}
      {camera.input}
      {photos.input}
      {files.input}
      <Sheet open={open} onOpenChange={onOpenChange} title="Add a document" description="Choose how to add it.">
        <Group>
          <Row leading={<Tile icon={Camera} />} label="Take a photo" description="Best for cards and single pages" chevron={false} onClick={camera.open} />
          <Row leading={<Tile icon={Images} />} label="Choose from photos" chevron={false} onClick={photos.open} />
          <Row leading={<Tile icon={FileUp} />} label="Choose a file" description="PDFs, scans, anything saved" chevron={false} onClick={files.open} />
        </Group>
      </Sheet>
    </>
  );
}
