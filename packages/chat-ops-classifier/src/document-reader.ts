import type { DocumentReader, InvoiceFields } from "./types.js";

/** Test double: a map from media reference to the fields "read" from it. Unknown refs throw, like a reader facing a blurry photo. */
export class FixtureDocumentReader implements DocumentReader {
  constructor(private readonly fixtures: Record<string, InvoiceFields>) {}

  async readInvoice(mediaRef: string): Promise<InvoiceFields> {
    const fields = this.fixtures[mediaRef];
    if (!fields) throw new Error(`cannot read invoice fields from ${mediaRef}`);
    return { ...fields };
  }
}
