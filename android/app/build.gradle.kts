plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.remotedisplay.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.remotedisplay.player"
        minSdk = 26
        targetSdk = 34
        versionCode = 19
        versionName = "1.8.3"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "remotedisplay"
            keyPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
            // #81: AGP ignores enableV1Signing at minSdk>=24, so assembleRelease emits a
            // v2-only APK. The v1 (JAR) signature that some MDM-managed signage (MAXHUB)
            // requires is added by the `resignReleaseV1` task below (apksigner re-sign).
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Socket.IO client
    implementation("io.socket:socket.io-client:2.1.0")

    // WorkManager for background downloads
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Gson for JSON
    implementation("com.google.code.gson:gson:2.10.1")

    // OkHttp for file downloads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // #74/#75: unit tests for the Kotlin schedule evaluator (vector drift guard)
    testImplementation("junit:junit:4.13.2")
}

// #74/#75: point the evaluator drift-guard test at the SHARED vector contract
// (shared/schedule-vectors.json, the single source - no snapshot). rootProject is
// the android/ Gradle root; its parent is the repo root. Any ScheduleEval.kt edit
// that breaks a vector fails ScheduleEvalTest in CI.
tasks.withType<Test> {
    systemProperty("scheduleVectors", File(rootProject.projectDir.parentFile, "shared/schedule-vectors.json").absolutePath)
}

// #81: AGP ignores enableV1Signing at minSdk>=24, so `assembleRelease` produces a
// v2-only APK - and some MDM-managed signage (MAXHUB/Pivot) silently removes a v2-only
// app on the next reboot because its boot integrity check expects a v1 (JAR) signature.
// Re-sign the assembled release APK with apksigner, forcing a low --min-sdk-version so
// the v1 signature is emitted alongside v2/v3. v1+v2+v3 verifies on every Android
// version (legacy MDM hardware via v1, modern Android via v2/v3).
tasks.register<Exec>("resignReleaseV1") {
    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk").get().asFile
    onlyIf { apk.exists() }
    doFirst {
        val sdkDir = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: rootProject.file("local.properties").takeIf { it.exists() }
                ?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.trim()
            ?: throw GradleException("#81 resign: set ANDROID_HOME or sdk.dir in local.properties")
        val buildTools = File(sdkDir, "build-tools").listFiles()
            ?.filter { it.isDirectory }?.maxByOrNull { it.name }
            ?: throw GradleException("#81 resign: no build-tools found under $sdkDir")
        commandLine(
            File(buildTools, "apksigner").absolutePath, "sign",
            "--ks", file("../release-key.jks").absolutePath,
            "--ks-key-alias", (System.getenv("KEY_ALIAS") ?: "remotedisplay"),
            "--ks-pass", "pass:" + (System.getenv("KEYSTORE_PASSWORD") ?: ""),
            "--key-pass", "pass:" + (System.getenv("KEY_PASSWORD") ?: ""),
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--min-sdk-version", "19",
            apk.absolutePath
        )
    }
}
// AGP registers assembleRelease lazily, so match it when/after it's created.
tasks.matching { it.name == "assembleRelease" }.configureEach { finalizedBy("resignReleaseV1") }
