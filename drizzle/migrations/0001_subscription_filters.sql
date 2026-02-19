ALTER TABLE `subscriptions`
  ADD COLUMN `include_keywords` text NULL,
  ADD COLUMN `exclude_keywords` text NULL,
  ADD COLUMN `price_min_cents` int unsigned NULL,
  ADD COLUMN `price_max_cents` int unsigned NULL;

