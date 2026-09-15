package com.pronto.omnishell.network

import kotlinx.serialization.Serializable

@Serializable
data class NativeFetchResponse(
    val status: Int,
    val statusText: String,
    val headers: Map<String, String>,
    val body: String
)
