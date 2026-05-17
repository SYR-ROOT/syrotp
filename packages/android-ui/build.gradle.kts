// Top-level build file. Plugin coordinates declared here, applied by
// each per-module script (`library/build.gradle.kts`,
// `demo/build.gradle.kts`).
plugins {
    id("com.android.library") version "8.7.0" apply false
    id("com.android.application") version "8.7.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21" apply false
}
