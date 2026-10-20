-- Hand-written: the view backed only the week-1 /repos/:id/flaky-tests route, which is gone. The API's flaky ranking and
-- summary use flaky/flakeRateQueries.ts (perShaCte). A view holds no data; 0001 shows how to re-create it.
DROP VIEW IF EXISTS "flaky_tests";
