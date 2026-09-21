export interface MenuImage {
  key: string;
  url: string;
  width: number;
  height: number;
}
export interface MenuVisibility {
  visible: boolean;
  reasons: string[];
  variants: { id: string; visible: boolean; reasons: string[] }[];
}
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
  image: MenuImage | null;
  counterVisibility: MenuVisibility;
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
      version: number;
      id: string;
      name: string;
      kitchenName: string | null;
      image: MenuImage | null;
      variants: {
        id: string;
        name: string;
        displayLabel: string | null;
        price: string;
        available: boolean;
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
  imageKey?: string | null;
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
