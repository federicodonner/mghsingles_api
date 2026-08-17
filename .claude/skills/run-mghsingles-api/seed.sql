-- Minimal dev seed for mghsingles_api.
--
-- Run AFTER `npx prisma@6.14.0 db push` has created the schema.
-- Do NOT load mghsingles.psql: that dump predates the current schema.prisma
-- and its only real content is the two lookup tables reproduced below.
--
--   psql -d mghsingles -v ON_ERROR_STOP=1 \
--     -f .claude/skills/run-mghsingles-api/seed.sql
--
-- Idempotent: safe to re-run. Card data is real Scryfall data (real ids and
-- image URLs), so the store actually renders card images.

INSERT INTO cardcondition (id, name) VALUES
  (1,'NM'),(2,'EX'),(3,'VG'),(4,'G'),(5,'damaged')
ON CONFLICT (id) DO NOTHING;

INSERT INTO cardlanguage (id, name) VALUES
  (1,'Inglés'),(2,'Español'),(3,'Francés'),(4,'Portugués'),
  (5,'Alemán'),(6,'Japonés'),(7,'Chino')
ON CONFLICT (id) DO NOTHING;

SELECT setval('cardcondition_id_seq', (SELECT max(id) FROM cardcondition));
SELECT setval('cardlanguage_id_seq',  (SELECT max(id) FROM cardlanguage));

INSERT INTO cardset (cardset,cardsetname,releasedate,iconsvguri) VALUES ('lea','Limited Edition Alpha','1993-08-05','https://svgs.scryfall.io/sets/lea.svg') ON CONFLICT (cardset) DO NOTHING;
INSERT INTO cardset (cardset,cardsetname,releasedate,iconsvguri) VALUES ('m19','Core Set 2019','2018-07-13','https://svgs.scryfall.io/sets/m19.svg') ON CONFLICT (cardset) DO NOTHING;
INSERT INTO cardset (cardset,cardsetname,releasedate,iconsvguri) VALUES ('m21','Core Set 2021','2020-07-03','https://svgs.scryfall.io/sets/m21.svg') ON CONFLICT (cardset) DO NOTHING;

INSERT INTO cardgeneral (scryfallid,name,cardsetcode,cardsetname,image,color,rarity,collectornumber,releasedatyear) VALUES ('b0faa7f2-b547-42c4-a810-839da50dadfe','Black Lotus','lea','Limited Edition Alpha','https://cards.scryfall.io/normal/front/b/0/b0faa7f2-b547-42c4-a810-839da50dadfe.jpg?1783948669',NULL,'rare','232',1993) ON CONFLICT (scryfallid) DO NOTHING;
INSERT INTO cardgeneral (scryfallid,name,cardsetcode,cardsetname,image,color,rarity,collectornumber,releasedatyear) VALUES ('0df55e3f-14de-46ef-b6b1-616618724d9e','Counterspell','lea','Limited Edition Alpha','https://cards.scryfall.io/normal/front/0/d/0df55e3f-14de-46ef-b6b1-616618724d9e.jpg?1783948707','U','uncommon','54',1993) ON CONFLICT (scryfallid) DO NOTHING;
INSERT INTO cardgeneral (scryfallid,name,cardsetcode,cardsetname,image,color,rarity,collectornumber,releasedatyear) VALUES ('d573ef03-4730-45aa-93dd-e45ac1dbaf4a','Lightning Bolt','lea','Limited Edition Alpha','https://cards.scryfall.io/normal/front/d/5/d573ef03-4730-45aa-93dd-e45ac1dbaf4a.jpg?1783948684','R','common','161',1993) ON CONFLICT (scryfallid) DO NOTHING;
INSERT INTO cardgeneral (scryfallid,name,cardsetcode,cardsetname,image,color,rarity,collectornumber,releasedatyear) VALUES ('73542493-cd0b-4bb7-a5b8-8f889c76e4d6','Llanowar Elves','m19','Core Set 2019','https://cards.scryfall.io/normal/front/7/3/73542493-cd0b-4bb7-a5b8-8f889c76e4d6.jpg?1783934474','G','common','314',2018) ON CONFLICT (scryfallid) DO NOTHING;
INSERT INTO cardgeneral (scryfallid,name,cardsetcode,cardsetname,image,color,rarity,collectornumber,releasedatyear) VALUES ('c4300d24-1cae-4dd5-be7e-38cc677cf5bd','Sol Ring','lea','Limited Edition Alpha','https://cards.scryfall.io/normal/front/c/4/c4300d24-1cae-4dd5-be7e-38cc677cf5bd.jpg?1783948661',NULL,'uncommon','269',1993) ON CONFLICT (scryfallid) DO NOTHING;
