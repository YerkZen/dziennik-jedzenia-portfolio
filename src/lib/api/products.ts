import { apiRequest } from "./client";
import { decimalToNumber } from "@/lib/contracts/decimal";
import type { Product } from "@/lib/nutrition/types";

export interface ProductDto {
  id: string;
  name: string;
  basis_unit: "g" | "ml";
  kcal_per_100: string;
  protein_per_100: string;
  fat_per_100: string;
  carbs_per_100: string;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductPage {
  items: ProductDto[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ProductCreateInput {
  id: string;
  name: string;
  basis_unit: "g" | "ml";
  kcal_per_100: string;
  protein_per_100: string;
  fat_per_100: string;
  carbs_per_100: string;
}

export interface ProductUpdateInput {
  name: string;
  kcal_per_100: string;
  protein_per_100: string;
  fat_per_100: string;
  carbs_per_100: string;
}

export interface MutationAck {
  resource_id: string;
  applied_revision: number;
  current_revision: number;
  replayed: boolean;
  deleted: boolean;
}

export function listProducts(q: string): Promise<ProductPage> {
  const params = new URLSearchParams({ limit: "100", offset: "0" });
  if (q.trim()) params.set("q", q.trim());
  return apiRequest<ProductPage>(`/api/v1/products?${params.toString()}`);
}

export function getProduct(id: string): Promise<ProductDto> {
  return apiRequest<ProductDto>(`/api/v1/products/${encodeURIComponent(id)}`);
}

export function createProduct(input: ProductCreateInput, idempotencyKey: string) {
  return apiRequest<MutationAck>("/api/v1/products", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function updateProduct(
  productId: string,
  revision: number,
  input: ProductUpdateInput,
  idempotencyKey: string,
) {
  return apiRequest<MutationAck>(`/api/v1/products/${encodeURIComponent(productId)}`, {
    method: "PUT",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export function archiveProduct(productId: string, revision: number, idempotencyKey: string) {
  return apiRequest<MutationAck>(`/api/v1/products/${encodeURIComponent(productId)}`, {
    method: "DELETE",
    headers: { "If-Match": `"${revision}"`, "Idempotency-Key": idempotencyKey },
  });
}

export function toNutritionProduct(product: ProductDto): Product {
  return {
    id: product.id,
    name: product.name,
    basisUnit: product.basis_unit,
    kcal: decimalToNumber(product.kcal_per_100),
    protein: decimalToNumber(product.protein_per_100),
    fat: decimalToNumber(product.fat_per_100),
    carbs: decimalToNumber(product.carbs_per_100),
  };
}
