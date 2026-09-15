package com.pronto.omnishell.network

import kotlinx.serialization.Serializable

@Serializable
data class NativeFetchRequest(
    val method: String = "GET",
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null
)
