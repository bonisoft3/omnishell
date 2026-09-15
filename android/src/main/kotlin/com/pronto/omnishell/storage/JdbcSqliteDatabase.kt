package com.pronto.omnishell.storage

import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.Types

class JdbcSqliteDatabase(val jdbcUrl: String = "jdbc:sqlite::memory:") : SqlDatabase {
    private val connection: Connection = DriverManager.getConnection(jdbcUrl)

    @Synchronized
    override fun exec(sql: String, params: List<Any?>): SqlExecResult {
        connection.prepareStatement(sql).use { statement ->
            bindParameters(statement, params)
            val rowsAffected = statement.executeUpdate().toLong()
            val lastId = fetchLastInsertId()
            return SqlExecResult(rowsAffected = rowsAffected, lastInsertRowId = lastId)
        }
    }

    @Synchronized
    override fun query(sql: String, params: List<Any?>): List<Map<String, Any?>> {
        connection.prepareStatement(sql).use { statement ->
            bindParameters(statement, params)
            statement.executeQuery().use { rs ->
                val meta = rs.metaData
                val colCount = meta.columnCount
                val results = mutableListOf<Map<String, Any?>>()
                while (rs.next()) {
                    val row = mutableMapOf<String, Any?>()
                    for (i in 1..colCount) {
                        val colName = meta.getColumnLabel(i)
                        row[colName] = rs.getObject(i)
                    }
                    results.add(row)
                }
                return results
            }
        }
    }

    private fun bindParameters(statement: PreparedStatement, params: List<Any?>) {
        params.forEachIndexed { index, value ->
            val paramIndex = index + 1
            when (value) {
                null -> statement.setNull(paramIndex, Types.NULL)
                is String -> statement.setString(paramIndex, value)
                is Int -> statement.setInt(paramIndex, value)
                is Long -> statement.setLong(paramIndex, value)
                is Double -> statement.setDouble(paramIndex, value)
                is Float -> statement.setFloat(paramIndex, value)
                is Boolean -> statement.setInt(paramIndex, if (value) 1 else 0)
                is ByteArray -> statement.setBytes(paramIndex, value)
                else -> statement.setString(paramIndex, value.toString())
            }
        }
    }

    private fun fetchLastInsertId(): Long {
        connection.createStatement().use { stmt ->
            stmt.executeQuery("SELECT last_insert_rowid()").use { rs ->
                return if (rs.next()) rs.getLong(1) else 0L
            }
        }
    }

    override fun close() {
        if (!connection.isClosed) {
            connection.close()
        }
    }
}
