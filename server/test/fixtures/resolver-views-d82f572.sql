-- Frozen copy of the resolver views at base d82f572 (pre corporate playlists).
-- Used by test/corporate-upgrade.test.js to prove the upgrade changes no screen. NEVER edit.
CREATE VIEW device_inherited_playlist AS
  SELECT d.id AS device_id,
         (SELECT vw.playlist_id FROM video_walls vw
           WHERE vw.id = d.wall_id AND vw.playlist_id IS NOT NULL) AS wall_playlist_id,
         (SELECT g.playlist_id FROM device_groups g
            JOIN device_group_members m ON m.group_id = g.id
           WHERE m.device_id = d.id AND g.playlist_id IS NOT NULL
           ORDER BY g.priority DESC, g.created_at ASC, g.id ASC LIMIT 1) AS group_playlist_id
    FROM devices d;
CREATE VIEW device_resolved_playlist AS
  SELECT d.id AS device_id,
         -- 'none' short-circuits everything: "deliberately plays nothing" is not the same as
         -- "nothing was chosen". Without this branch the backfill's carefully-preserved dark
         -- screens inherit their group's playlist and light up during an upgrade.
         CASE WHEN d.playlist_source = 'none' AND d.scheduled_playlist_id IS NULL THEN NULL ELSE COALESCE(
           -- An ACTIVE SCHEDULE outranks everything, including a device override and 'none': it is
           -- the operator saying "at this time of day, this instead". It outranks 'none' too, or a
           -- deliberately dark screen could never be scheduled to show anything.
           d.scheduled_playlist_id,
           CASE WHEN d.playlist_source = 'device' THEN d.playlist_id END,
           i.wall_playlist_id,
           i.group_playlist_id,
           -- LAST RESORT: an id nobody has classified. playlist_source is NULL both for "inherits"
           -- and for "a writer set playlist_id and never learned about the column", and resolving
           -- the second case to NOTHING turned 12 tests red. Honouring the raw id BELOW the
           -- inherited sources means an unconverted writer keeps working while the migration is
           -- staged, and a stale copy still loses to the group.
           d.playlist_id
         ) END AS playlist_id,
         CASE
           WHEN d.scheduled_playlist_id IS NOT NULL THEN 'schedule'
           WHEN d.playlist_source = 'none' THEN NULL
           WHEN d.playlist_source = 'device' AND d.playlist_id IS NOT NULL THEN 'device'
           WHEN i.wall_playlist_id  IS NOT NULL THEN 'wall'
           WHEN i.group_playlist_id IS NOT NULL THEN 'group'
           WHEN d.playlist_id IS NOT NULL THEN 'device'
           ELSE NULL
         END AS source,
         -- Layout follows the same rule, for the same reason: the scheduler used to overwrite
         -- devices.layout_id and revert it from memory. There is no group or wall tier here —
         -- a layout has only ever been per-device.
         COALESCE(d.scheduled_layout_id, d.layout_id) AS layout_id
    FROM devices d
    JOIN device_inherited_playlist i ON i.device_id = d.id;
