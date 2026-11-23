import { fireEvent, render, screen } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProductForm } from "./ProductForm";

const initial = {
  name: "Ryż",
  basisUnit: "g" as const,
  kcal: "350",
  protein: "7",
  fat: "1",
  carbs: "78",
};

describe("ProductForm technical behavior", () => {
  it("requires an explicit unit when a label proposal has no known basis", () => {
    const onSubmit = vi.fn();
    render(
      createElement(ProductForm, {
        initial: { ...initial, basisUnit: "" },
        draftKey: `unknown-label-unit-${randomUUID()}`,
        onSubmit,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zapisz produkt" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Jednostka produktu")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Jednostka produktu")).toHaveFocus();
  });

  it("focuses the first invalid field and exposes its validation state", () => {
    render(
      createElement(ProductForm, {
        initial,
        draftKey: `product-form-invalid-${randomUUID()}`,
        onSubmit: vi.fn(),
      }),
    );
    const protein = screen.getByText("Białko").closest("label")?.querySelector("input");
    expect(protein).not.toBeNull();

    fireEvent.change(protein!, { target: { value: "1.001" } });
    fireEvent.click(screen.getByRole("button", { name: "Zapisz produkt" }));

    expect(protein).toHaveAttribute("aria-invalid", "true");
    expect(protein).toHaveFocus();
  });

  it("keeps edited values visible when the server rejects a save", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("Produkt zmienił się od czasu jego wczytania."));
    render(
      createElement(ProductForm, {
        initial,
        draftKey: `product-form-conflict-${randomUUID()}`,
        submitLabel: "Zapisz zmiany",
        onSubmit,
      }),
    );
    const energy = screen.getByText("Energia").closest("label")?.querySelector("input");
    expect(energy).not.toBeNull();
    fireEvent.change(energy!, { target: { value: "360" } });
    fireEvent.click(screen.getByRole("button", { name: "Zapisz zmiany" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Produkt zmienił się od czasu jego wczytania.",
    );
    expect(energy).toHaveValue("360");
  });
});
