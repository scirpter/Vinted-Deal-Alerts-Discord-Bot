CREATE TABLE `discord_users` (
  `discord_user_id` varchar(32) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`discord_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint

CREATE TABLE `vinted_accounts` (
  `discord_user_id` varchar(32) NOT NULL,
  `region` varchar(8) NOT NULL,
  `encrypted_refresh_token` text NOT NULL,
  `pickup_point` varchar(255) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`discord_user_id`),
  CONSTRAINT `vinted_accounts_user_fk`
    FOREIGN KEY (`discord_user_id`) REFERENCES `discord_users`(`discord_user_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint

CREATE TABLE `subscriptions` (
  `id` varchar(26) NOT NULL,
  `discord_guild_id` varchar(32) NOT NULL,
  `discord_user_id` varchar(32) NOT NULL,
  `discord_channel_id` varchar(32) NOT NULL,
  `label` varchar(100) NOT NULL,
  `search_url` text NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT 1,
  `autobuy_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `last_seen_item_id` bigint unsigned NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `subscriptions_guild_idx` (`discord_guild_id`),
  KEY `subscriptions_user_idx` (`discord_user_id`),
  CONSTRAINT `subscriptions_user_fk`
    FOREIGN KEY (`discord_user_id`) REFERENCES `discord_users`(`discord_user_id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--> statement-breakpoint

CREATE TABLE `posted_items` (
  `id` varchar(26) NOT NULL,
  `subscription_id` varchar(26) NOT NULL,
  `vinted_item_id` bigint unsigned NOT NULL,
  `discord_message_id` varchar(32) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `posted_items_subscription_item_uniq` (`subscription_id`, `vinted_item_id`),
  CONSTRAINT `posted_items_subscription_fk`
    FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
