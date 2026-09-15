package com.pronto.omnishell.storage

interface SqlDatabase : AutoCloseable {
    fun exec(sql: String, params: List<Any?> = emptyList()): SqlExecResult
    fun query(sql: String, params: List<Any?> = emptyList()): List<Map<String, Any?>>
}
