/**
 * Turns catalog vocabularies into channel-agnostic button rows.
 *
 * Nothing here knows about Telegram. The channel adapter decides how to render
 * an `InlineButton`, which is what keeps the adapter free of domain imports.
 */
import { getVocabulary } from "./catalog";
import type { FieldCatalog, FieldSpec, InlineButton } from "./types";

/** Labels longer than this get a row to themselves so they stay readable. */
const WIDE_LABEL_CHARS = 14;
const BUTTONS_PER_ROW = 2;

export function iconFor(catalog: FieldCatalog, value: string): string {
  return catalog.icons[value] ?? "🔹";
}

/** Lays buttons out two-up, breaking wide labels onto their own row. */
export function layoutButtons(buttons: InlineButton[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  let current: InlineButton[] = [];

  for (const button of buttons) {
    if (button.text.length > WIDE_LABEL_CHARS) {
      if (current.length > 0) {
        rows.push(current);
        current = [];
      }
      rows.push([button]);
      continue;
    }
    current.push(button);
    if (current.length === BUTTONS_PER_ROW) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Buttons for one enum-typed field. Returns null for free-text fields. */
export function fieldButtons(catalog: FieldCatalog, field: FieldSpec): InlineButton[][] | null {
  const vocabulary = getVocabulary(catalog, field);
  if (!vocabulary || vocabulary.length === 0) return null;
  return layoutButtons(vocabulary.map((value) => valueButton(catalog, value)));
}

/**
 * Một nút cho một giá trị trong bảng tra.
 *
 * `callbackData` đi qua nhãn ngắn khi giá trị chuẩn quá dài cho kênh chat —
 * xem `MAX_CALLBACK_DATA_BYTES`. Đường về do `createCatalog` lo: nó đã đăng ký
 * nhãn ngắn thành synonym của giá trị chuẩn.
 */
function valueButton(catalog: FieldCatalog, value: string): InlineButton {
  const label = catalog.buttonLabels[value] ?? value;
  return { text: `${iconFor(catalog, value)} ${label}`, callbackData: label };
}

/** Builds buttons from an explicit list of labels, used for menus and confirmations. */
export function labelButtons(catalog: FieldCatalog, labels: string[]): InlineButton[][] {
  return layoutButtons(labels.map((label) => valueButton(catalog, label)));
}
