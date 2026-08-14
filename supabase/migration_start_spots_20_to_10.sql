-- Reduce el cupo de fundador de Start™ de 20 a 10 plazas, para que quede
-- igualado con Basic™/Lite™/Pro™ (todos a 10). Motivo: decisión del founder,
-- 20 plazas para el escalón más barato desequilibraba el programa.
--
-- No se limita a poner spots_left=10 a lo bruto: resta 10 al valor actual,
-- así que si ya se hubiera vendido alguna plaza de fundador de Start™ antes
-- de ejecutar esto, la resta se conserva en vez de regalar 10 plazas de
-- vuelta. greatest(0, ...) evita que el contador baje de cero.
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run). Requiere
-- migration_founding_spots.sql, migration_founding_spots_start_basic.sql y
-- migration_rename_start_basic_tiers.sql ya aplicadas.

update founding_spots set spots_left = greatest(0, spots_left - 10) where tier = 'start';
