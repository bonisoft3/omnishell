package com.pronto.omnishell.storage

import kotlinx.serialization.Serializable

@Serializable
data class SqlExecResult(
    val rowsAffected: Long,
    val lastInsertRowId: Long
)
