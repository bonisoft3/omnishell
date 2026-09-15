package com.pronto.omnishell.bridge

import com.pronto.omnishell.storage.JdbcSqliteDatabase
import com.pronto.omnishell.storage.SqliteKeyValueStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StorageBridgeTest {
    private lateinit var db: JdbcSqliteDatabase
    private lateinit var bridge: StorageBridge

    @BeforeEach
    fun setUp() {
        db = JdbcSqliteDatabase("jdbc:sqlite::memory:")
        val kv = SqliteKeyValueStore(db)
        bridge = StorageBridge(kv, db)
    }

    @AfterEach
    fun tearDown() {
        bridge.close()
    }

    @Test
    fun testKeyValueOperations() {
        assertNull(bridge.kvGet("user_token"))

        bridge.kvSet("user_token", "secret-xyz")
        assertEquals("secret-xyz", bridge.kvGet("user_token"))

        bridge.kvSet("mode", "dark")
        val keysJson = bridge.kvKeys()
        assertTrue(keysJson.contains("user_token"))
        assertTrue(keysJson.contains("mode"))

        val deleted = bridge.kvDelete("mode")
        assertTrue(deleted)
        assertNull(bridge.kvGet("mode"))

        bridge.kvClear()
        assertNull(bridge.kvGet("user_token"))
        assertEquals("[]", bridge.kvKeys())
    }

    @Test
    fun testSqlExecAndQuery() {
        val createRes = bridge.sqlExec(
            "CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, amount REAL);",
            null
        )
        assertTrue(createRes.contains("\"rowsAffected\":0"))

        val insertRes = bridge.sqlExec(
            "INSERT INTO items (name, amount) VALUES (?, ?);",
            "[\"Widget A\", 42.5]"
        )
        assertTrue(insertRes.contains("\"rowsAffected\":1"))
        assertTrue(insertRes.contains("\"lastInsertRowId\":1"))

        bridge.sqlExec(
            "INSERT INTO items (name, amount) VALUES (?, ?);",
            "[\"Widget B\", 99.0]"
        )

        val queryRes = bridge.sqlQuery(
            "SELECT * FROM items WHERE amount > ? ORDER BY id ASC;",
            "[50]"
        )
        assertTrue(queryRes.contains("\"name\":\"Widget B\""))
        assertTrue(!queryRes.contains("\"name\":\"Widget A\""))
    }
}
