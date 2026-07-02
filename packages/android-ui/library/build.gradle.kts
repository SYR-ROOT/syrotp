plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    `maven-publish`
}

// Maven coordinates published to Sonatype / Maven Central.
// Aligned with `sdk-kotlin` so the SYROTP namespace is a single
// `dev.syrotp:*` group. `0.0.0-dev` is the placeholder until the
// first real Maven Central release.
group = "dev.syrotp"
version = "0.0.0-dev"

android {
    namespace = "dev.syrotp.ui"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // Lets us use `java.time.Instant` on minSdk 24 — that API was
        // added at API 26. Desugaring is the standard Android workaround.
        isCoreLibraryDesugaringEnabled = true
    }

    publishing {
        singleVariant("release") {
            withSourcesJar()
        }
    }
}

// AGP creates the `release` software component late in the
// configuration phase, so the publication has to be wired up after
// the android block has been evaluated.
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components["release"])
                groupId = "dev.syrotp"
                artifactId = "android-ui"
                version = project.version.toString()
                pom {
                    name.set("SYROTP Android UI")
                    description.set("Jetpack Compose verification screen for the Syrian Reverse OTP Protocol")
                    url.set("https://github.com/SYR-ROOT/syrotp")
                    licenses {
                        license {
                            name.set("MIT")
                            url.set("https://opensource.org/licenses/MIT")
                            distribution.set("repo")
                        }
                    }
                    developers {
                        developer {
                            id.set("syr-root")
                            name.set("Muhammed Shekho")
                            url.set("https://github.com/SYR-ROOT")
                        }
                    }
                    scm {
                        connection.set("scm:git:git://github.com/SYR-ROOT/syrotp.git")
                        developerConnection.set("scm:git:ssh://github.com:SYR-ROOT/syrotp.git")
                        url.set("https://github.com/SYR-ROOT/syrotp/tree/main/packages/android-ui")
                    }
                    issueManagement {
                        system.set("GitHub Issues")
                        url.set("https://github.com/SYR-ROOT/syrotp/issues")
                    }
                }
            }
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
