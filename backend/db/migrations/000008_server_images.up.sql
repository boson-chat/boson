-- Server owners can set an icon + banner for their directory listing. Both
-- are stored in R2 (like user avatars) and these columns hold the object key;
-- the API derives the public CDN URL. Nullable — listings without images
-- fall back to a generated placeholder client-side.
ALTER TABLE servers
    ADD COLUMN icon_storage_key   text,
    ADD COLUMN banner_storage_key text;
