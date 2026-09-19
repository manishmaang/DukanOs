export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SalesChannel {
  code: string;
  name: string;
  active: boolean;
}
export interface VariantChannel {
  channelCode: string;
  price: string;
  available: boolean;
}
export interface MenuVariant {
  id: string;
  name: string;
  displayLabel: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  channels: VariantChannel[];
}
export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  kitchenName: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  variants: MenuVariant[];
}
export interface MenuCatalog {
  categories: MenuCategory[];
  items: MenuItem[];
  channels: SalesChannel[];
}
export interface OperationalMenu {
  channel: SalesChannel;
  categories: {
    id: string;
    name: string;
    items: {
      id: string;
      name: string;
      kitchenName: string | null;
      variants: {
        id: string;
        name: string;
        displayLabel: string | null;
        price: string;
      }[];
    }[];
  }[];
}

export interface MenuVariantInput {
  id?: string;
  name: string;
  displayLabel?: string | null;
  active?: boolean;
  channels?: VariantChannel[];
}
export interface MenuItemInput {
  name: string;
  categoryId: string;
  description?: string | null;
  kitchenName?: string | null;
  active?: boolean;
  variants: MenuVariantInput[];
}
export interface MenuItemSave extends MenuItemInput {
  version: number;
}
