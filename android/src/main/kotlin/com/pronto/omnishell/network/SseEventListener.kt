package com.pronto.omnishell.network

interface SseEventListener {
    fun onOpen()
    fun onEvent(id: String?, type: String, data: String)
    fun onError(throwable: Throwable)
    fun onClosed()
}
