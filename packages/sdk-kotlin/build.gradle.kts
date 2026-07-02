plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    application
    `maven-publish`
}

application {
    // Used for the live cross-stack CI step:
    //   ./gradlew run --args="+963991234567 login"
    // Reads SYROTP_BASE_URL + SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) from env.
    mainClass.set("io.syrotp.sdk.examples.QuickstartKt")
}

// Maven coordinates published to Sonatype / Maven Central. The Java
// package stays `io.syrotp.sdk` (see `Sources/`), since Maven group !=
// Java package. Keeping the group as `dev.syrotp` so the SYROTP Maven
// coordinates form a single namespace across `sdk-kotlin` and
// `android-ui`. `0.0.0-dev` is the metadata-only placeholder until
// the first real Maven Central release — bumped at tag time.
group = "dev.syrotp"
version = "0.0.0-dev"

repositories {
    mavenCentral()
}

kotlin {
    // JDK 17 is the LTS that v0.4 SDKs target. Anything older drops
    // most production JVM users; anything newer rules out long-tail
    // server deployments on 17.
    jvmToolchain(17)
}

dependencies {
    // OkHttp is the smallest mainstream HTTP client on JVM; the
    // Android gateway uses it too, so the SDK and gateway share a
    // single transport vocabulary across the codebase.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}

// Reproducible jars — same inputs, same SHA. Helpful for downstream
// supply-chain checks once we publish to Maven Central.
tasks.withType<Jar>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

java {
    withSourcesJar()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            // Override the artifactId so the published coordinates
            // are `dev.syrotp:sdk-kotlin:<version>` regardless of
            // `rootProject.name`. Keeps the artifact name aligned
            // with the directory name across the SYROTP packages.
            artifactId = "sdk-kotlin"
            from(components["java"])
            pom {
                name.set("SYROTP Kotlin SDK")
                description.set("Official Kotlin/JVM SDK for the Syrian Reverse OTP Protocol")
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
                    url.set("https://github.com/SYR-ROOT/syrotp/tree/main/packages/sdk-kotlin")
                }
                issueManagement {
                    system.set("GitHub Issues")
                    url.set("https://github.com/SYR-ROOT/syrotp/issues")
                }
            }
        }
    }
}
