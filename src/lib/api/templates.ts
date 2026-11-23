import { apiRequest } from "./client";
import type { MutationAck, ProductDto } from "./products";

export interface TemplateItemDto {
  item_id: string;
  product: ProductDto;
  quantity: string;
  position: number;
}
export interface TemplateDto {
  id: string;
  name: string;
  revision: number;
  archived_at: string | null;
  items: TemplateItemDto[];
  created_at: string;
  updated_at: string;
}
export interface TemplateInput {
  name: string;
  items: {
    item_id: string;
    product_id: string;
    expected_product_revision: number;
    quantity: string;
  }[];
}
export function listTemplates(q = "", offset = 0) {
  return apiRequest<{ items: TemplateDto[]; has_more: boolean; offset: number; limit: number }>(
    `/api/v1/meal-templates?${new URLSearchParams({ q, limit: "100", offset: String(offset) })}`,
  );
}
export function getTemplate(id: string) {
  return apiRequest<TemplateDto>(`/api/v1/meal-templates/${encodeURIComponent(id)}`);
}
export function saveTemplate(
  id: string,
  revision: number | null,
  input: TemplateInput,
  key: string,
) {
  return apiRequest<MutationAck>(
    `/api/v1/meal-templates${revision === null ? "" : `/${encodeURIComponent(id)}`}`,
    {
      method: revision === null ? "POST" : "PUT",
      headers: {
        "Idempotency-Key": key,
        ...(revision === null ? {} : { "If-Match": `"${revision}"` }),
      },
      body: JSON.stringify(revision === null ? { id, ...input } : input),
    },
  );
}
export function archiveTemplate(id: string, revision: number, key: string) {
  return apiRequest<MutationAck>(`/api/v1/meal-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": key },
  });
}
