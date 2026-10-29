package dev.disnans.notifier

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * 通話中の音の出力先（受話口・スピーカー・有線イヤホン・Bluetooth）の切り替え。
 * Android 12（API 31）以降は getAvailableCommunicationDevices / setCommunicationDevice、
 * それより前は setSpeakerphoneOn / startBluetoothSco を使う。
 * 通話のあいだ（CallService が動いている間）は MODE_IN_COMMUNICATION にする。
 */
data class AudioOutput(val id: String, val label: String, val kind: String)

/**
 * 通話の音の経路を使う主体。従来の CallService（WebView の通話）と、ネイティブの通話（NativeCallService）。
 * 両方が同時に使うことはないが、片方の終わりがもう片方の経路を壊さないように、主体ごとに数える。
 */
enum class RouteOwner { LEGACY, NATIVE }

object CallAudio {
  private var previousMode: Int? = null
  private val leases = HashMap<RouteOwner, Int>()

  /**
   * 通話用に音の経路を整える。主体ごとに 1 つ数える。最初の主体だけが既定の出力先を選ぶ。
   * 初めて経路を使うときに、イヤホンがあればそれ、なければスピーカーにする。
   */
  @Synchronized
  fun begin(context: Context, owner: RouteOwner = RouteOwner.LEGACY) {
    val first = leases.isEmpty()
    leases[owner] = (leases[owner] ?: 0) + 1
    if (!first) return
    try {
      val am = manager(context)
      if (previousMode == null) previousMode = am.mode
      am.mode = AudioManager.MODE_IN_COMMUNICATION
      defaultOf(list(context))?.let { set(context, it.id) }
    } catch (e: Exception) {
      // 経路を整えられなくても通話は続ける（端末の既定の経路を使う）
      DiagLog.w("[call] 音の経路を整えられませんでした。端末の既定の経路を使います", e)
    }
  }

  /**
   * 主体の数を 1 つ減らす。対応する begin が無い end は何もしない（別の主体の経路を戻さない）。
   * 最後の主体が終わったら、経路と音声のモードを元に戻す。
   */
  @Synchronized
  fun end(context: Context, owner: RouteOwner = RouteOwner.LEGACY) {
    val n = leases[owner] ?: return
    if (n <= 1) leases.remove(owner) else leases[owner] = n - 1
    if (leases.isNotEmpty()) return
    try {
      val am = manager(context)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          am.clearCommunicationDevice()
        } else {
          legacyReset(am)
        }
      } catch (e: Exception) {
        // 元に戻せなくても続ける
      }
      previousMode?.let { am.mode = it }
    } catch (e: Exception) {
      DiagLog.w("[call] 音の経路を元に戻せませんでした", e)
    }
    previousMode = null
  }

  @Suppress("DEPRECATION")
  private fun legacyReset(am: AudioManager) {
    am.stopBluetoothSco()
    am.isBluetoothScoOn = false
    am.isSpeakerphoneOn = false
  }

  /** 使える出力先。id は set に渡す。権限が無い・使えないときは空（既定の経路のまま） */
  fun list(context: Context): List<AudioOutput> = try {
    listOrThrow(context)
  } catch (e: Exception) {
    DiagLog.w("[call] 出力先の一覧を取れませんでした（既定の経路を使います）", e)
    emptyList()
  }

  private fun listOrThrow(context: Context): List<AudioOutput> {
    val am = manager(context)
    val devices: List<AudioDeviceInfo> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      am.availableCommunicationDevices
    } else {
      am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    }
    val out = ArrayList<AudioOutput>()
    var hasSpeaker = false
    var hasEarpiece = false
    for (d in devices) {
      val kind = kindOf(d.type) ?: continue
      when (kind) {
        "speaker" -> if (hasSpeaker) continue else hasSpeaker = true
        "earpiece" -> if (hasEarpiece) continue else hasEarpiece = true
      }
      val name = d.productName?.toString().orEmpty()
      val label = when (kind) {
        "earpiece" -> "受話口"
        "speaker" -> "スピーカー"
        "wired" -> if (name.isNotEmpty()) "イヤホン（$name）" else "イヤホン"
        else -> if (name.isNotEmpty()) "Bluetooth（$name）" else "Bluetooth"
      }
      val id = if (kind == "earpiece" || kind == "speaker") kind else "$kind:${d.id}"
      // Bluetooth は A2DP と SCO が両方出ることがある。通話は SCO / LE なので、同じ名前なら重ねない
      if (out.any { it.kind == kind && it.label == label }) continue
      out.add(AudioOutput(id, label, kind))
    }
    return out
  }

  /** 通話を始めるときの既定の出力先: Bluetooth、なければイヤホン、なければスピーカー、なければ受話口（begin だけが使う） */
  private fun defaultOf(outs: List<AudioOutput>): AudioOutput? =
    outs.firstOrNull { it.kind == "bluetooth" } ?: outs.firstOrNull { it.kind == "wired" } ?: outs.firstOrNull { it.kind == "speaker" } ?: outs.firstOrNull()

  /**
   * 現在の出力先の id。わからなければ null（画面は未選択と出す）。
   * 通話の前は null。end() の後の communicationDevice は、システムの既定（多くは受話口）で、利用者の選択ではない。
   */
  fun current(context: Context): String? = try {
    currentOrThrow(context)
  } catch (e: Exception) {
    DiagLog.w("[call] 今の出力先を取れませんでした", e)
    null
  }

  private fun currentOrThrow(context: Context): String? {
    if (previousMode == null) return null
    val am = manager(context)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val d = am.communicationDevice ?: return null
      val kind = kindOf(d.type) ?: return null
      val id = if (kind == "earpiece" || kind == "speaker") kind else "$kind:${d.id}"
      // 同じ種類・名前を重ねて隠した分があるので、一覧にある id に寄せる
      val outs = list(context)
      return outs.firstOrNull { it.id == id }?.id ?: outs.firstOrNull { it.kind == kind }?.id
    }
    @Suppress("DEPRECATION")
    return when {
      am.isBluetoothScoOn -> list(context).firstOrNull { it.kind == "bluetooth" }?.id
      am.isSpeakerphoneOn -> "speaker"
      else -> list(context).firstOrNull { it.kind == "wired" }?.id ?: "earpiece"
    }
  }

  /**
   * 出力先を切り替える。見つからない・権限が無い・使えないときは false（既定の経路のまま。通話は続ける）。
   */
  fun set(context: Context, id: String): Boolean = try {
    setOrThrow(context, id)
  } catch (e: Exception) {
    DiagLog.w("[call] 出力先を切り替えられませんでした（既定の経路のまま）", e)
    false
  }

  private fun setOrThrow(context: Context, id: String): Boolean {
    val am = manager(context)
    val target = list(context).firstOrNull { it.id == id } ?: return false
    if (am.mode != AudioManager.MODE_IN_COMMUNICATION) am.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val dev = am.availableCommunicationDevices.firstOrNull { d ->
        val kind = kindOf(d.type)
        kind == target.kind && (kind == "earpiece" || kind == "speaker" || "$kind:${d.id}" == id || d.productName?.toString().orEmpty().let { n -> target.label.contains(n) && n.isNotEmpty() })
      } ?: return false
      return am.setCommunicationDevice(dev)
    }
    @Suppress("DEPRECATION")
    when (target.kind) {
      "speaker" -> {
        am.stopBluetoothSco(); am.isBluetoothScoOn = false
        am.isSpeakerphoneOn = true
      }
      "bluetooth" -> {
        am.isSpeakerphoneOn = false
        am.startBluetoothSco(); am.isBluetoothScoOn = true
      }
      else -> {
        // 受話口・有線イヤホンは、スピーカーと Bluetooth を切れば自動でそちらへ出る
        am.stopBluetoothSco(); am.isBluetoothScoOn = false
        am.isSpeakerphoneOn = false
      }
    }
    return true
  }

  private fun manager(context: Context) = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun kindOf(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
    else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_HEARING_AID)) "bluetooth" else null
  }
}
