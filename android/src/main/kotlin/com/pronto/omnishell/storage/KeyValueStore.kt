package com.pronto.omnishell.storage

interface KeyValueStore {
    fun get(key: String): String?
    fun set(key: String, value: String)
    fun delete(key: String): Boolean
    fun clear()
    fun keys(): List<String>
}
