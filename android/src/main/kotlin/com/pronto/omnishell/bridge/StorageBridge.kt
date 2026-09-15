package com.pronto.omnishell.bridge

import com.pronto.omnishell.storage.KeyValueStore
import com.pronto.omnishell.storage.SqlDatabase
import com.pronto.omnishell.storage.SqlExecResult
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

class StorageBridge(
    private val kvStore: KeyValueStore,
    private val sqlDb: SqlDatabase,
    private val json: Json = Json { ignoreUnknownKeys = true }
) : AutoCloseable {

    fun kvGet(key: String): String? = kvStore.get(key)

    fun kvSet(key: String, value: String) {
        kvStore.set(key, value)
    }

    fun kvDelete(key: String): Boolean = kvStore.delete(key)

    fun kvClear() {
        kvStore.clear()
    }

    fun kvKeys(): String = json.encodeToString(kvStore.keys())

    fun sqlExec(sql: String, paramsJson: String?): String {
        val params = parseParams(paramsJson)
        val result = sqlDb.exec(sql, params)
        return json.encodeToString(result)
    }

    fun sqlQuery(sql: String, paramsJson: String?): String {
        val params = parseParams(paramsJson)
        val rows = sqlDb.query(sql, params)
        val jsonArray = buildJsonArray {
            for (row in rows) {
                add(buildJsonObject {
                    for ((k, v) in row) {
                        when (v) {
                            null -> put(k, JsonNull)
                            is Number -> put(k, JsonPrimitive(v))
                            is Boolean -> put(k, JsonPrimitive(v))
                            is String -> put(k, JsonPrimitive(v))
                            is ByteArray -> put(k, JsonPrimitive(String(v)))
                            else -> put(k, JsonPrimitive(v.toString()))
                        }
                    }
                })
            }
        }
        return json.encodeToString(jsonArray)
    }

    private fun parseParams(paramsJson: String?): List<Any?> {
        if (paramsJson.isNullOrBlank()) return emptyList()
        val element = json.parseToJsonElement(paramsJson)
        if (element !is JsonArray) return emptyList()
        return element.map { item ->
            when (item) {
                is JsonNull -> null
                is JsonPrimitive -> {
                    item.booleanOrNull
                        ?: item.longOrNull
                        ?: item.doubleOrNull
                        ?: item.content
                }
                else -> item.toString()
            }
        }
    }

    override fun close() {
        sqlDb.close()
    }
}
