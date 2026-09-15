package com.pronto.omnishell

import kotlinx.coroutines.flow.StateFlow

interface OmnishellEngine : AutoCloseable {
    val uiAst: StateFlow<String>
    fun start()
    fun dispatchAction(action: String)
}
