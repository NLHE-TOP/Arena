-- 002_product.sql — rename PokerTools competition references.
--
-- Product rooms and the derived room-result projection stored the external
-- PokerTools competition id as `tournament_id`; the canonical name is
-- `platform_competition_id`. The rename is applied in place so databases that
-- already applied `001_product.sql` keep their existing rows. `001_product.sql`
-- is hash-verified and therefore never edited.
ALTER TABLE product_rooms RENAME COLUMN tournament_id TO platform_competition_id;
ALTER TABLE product_room_results RENAME COLUMN tournament_id TO platform_competition_id;
