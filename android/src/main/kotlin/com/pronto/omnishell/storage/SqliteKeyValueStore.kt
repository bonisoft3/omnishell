package com.pronto.omnishell.storage

class SqliteKeyValueStore(private val db: SqlDatabase) : KeyValueStore {
    init {
        db.exec("CREATE TABLE IF NOT EXISTS __omnishell_kv (key TEXT PRIMARY KEY, value TEXT);")
    }

    override fun get(key: String): String? {
        val rows = db.query("SELECT value FROM __omnishell_kv WHERE key = ?;", listOf(key))
        return rows.firstOrNull()?.get("value")?.toString()
    }

    override fun set(key: String, value: String) {
        db.exec(
            "INSERT INTO __omnishell_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            listOf(key, value)
        )
    }

    override fun delete(key: String): Boolean {
        val result = db.exec("DELETE FROM __omnishell_kv WHERE key = ?;", listOf(key))
        return result.rowsAffected > 0
    }

    override fun clear() {
        db.exec("DELETE FROM __omnishell_kv;")
    }

    override fun keys(): List<String> {
        val rows = db.query("SELECT key FROM __omnishell_kv ORDER BY key ASC;")
        return rows.mapNotNull { it["key"]?.toString() }
    }
}
