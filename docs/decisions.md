ADRs

Chose Postgres given real database with free tier and PGlite for testing.  Sqlite would also be a choice but more limited upgrade path.

Full webhook flow chosen initially as stubbing it out would deferred critical path operations.  Had it been pursued later and been not successful, stubbing code may have been unnecessary.

Limit db changes so chose multi repo schema initially.

Flakey definition is based on commit SHA. It is pretty immutable, vs workflow/job
