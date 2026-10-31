# Database setup and updates

These ordered SQL scripts create and update the CRM database structure.
`DATABASE_SETUP_URL` is the schema owner's connection; `DATABASE_URL` is the restricted
application connection. Run `callerwhale-api setup-database`, or let server startup
apply pending scripts. `database_setup_history` records completed versions and their
checksums. Existing history is adopted automatically without replaying completed SQL.

Applied script bytes must stay unchanged, including comments and line endings.
Add a new numbered script for a new database change. The setup runner holds the
PostgreSQL database lock and commits scripts and history together, or rolls back.
