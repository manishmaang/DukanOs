CREATE TABLE menu_images (
 key uuid PRIMARY KEY,
 uploaded_by uuid NOT NULL REFERENCES users(id),
 width integer NOT NULL CHECK(width BETWEEN 1 AND 1024),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 1024),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX menu_images_created_idx ON menu_images(created_at);
CREATE INDEX menu_images_uploader_idx ON menu_images(uploaded_by,created_at);
ALTER TABLE menu_items ADD COLUMN image_key uuid REFERENCES menu_images(key);
CREATE UNIQUE INDEX menu_item_image_unique ON menu_items(image_key) WHERE image_key IS NOT NULL;
