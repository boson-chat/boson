ALTER TABLE servers
    DROP COLUMN IF EXISTS icon_storage_key,
    DROP COLUMN IF EXISTS banner_storage_key;
