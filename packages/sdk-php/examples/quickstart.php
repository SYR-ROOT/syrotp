<?php

declare(strict_types=1);

/**
 * Quickstart for the SYROTP PHP SDK.
 *
 * Reads SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) from
 * the environment — same convention as scripts/smoke.mjs and the
 * `syrotp` CLI.
 *
 * Run against a running SYROTP server:
 *
 *     export SYROTP_BASE_URL=http://localhost:3000
 *     export SYROTP_SECRET_KEY=sk_live_...
 *     php examples/quickstart.php +963991234567 login
 */

require __DIR__ . '/../vendor/autoload.php';

use Syrotp\Sdk\Errors\SyrotpError;
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\VerificationStatus;

$argv = $_SERVER['argv'] ?? [];
if (count($argv) < 3) {
    fwrite(STDERR, "usage: {$argv[0]} <phone> <purpose>\n");
    exit(2);
}

$baseUrl = getenv('SYROTP_BASE_URL') ?: '';
$apiKey = getenv('SYROTP_SECRET_KEY') ?: (getenv('SYROTP_PUBLIC_KEY') ?: '');
if ($baseUrl === '' || $apiKey === '') {
    fwrite(STDERR, "SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) must be set\n");
    exit(2);
}

$phone = $argv[1];
$purpose = $argv[2];

try {
    $client = new SyrotpClient(baseUrl: $baseUrl, apiKey: $apiKey);
    $v = $client->startVerification(phone: $phone, purpose: $purpose);
} catch (SyrotpError $e) {
    fwrite(STDERR, "start_verification failed: {$e}\n");
    exit(1);
}

if ($v->status !== VerificationStatus::Pending) {
    fwrite(STDERR, "unexpected status from start: {$v->status->value}\n");
    exit(1);
}

printf("verification id: %s\n", $v->id);
printf("  send: %s\n", $v->message ?? '');
printf("  to:   %s\n", $v->sendTo ?? '');
printf("  for phone %s\n", $v->phoneMasked);

// Demo only — cancel right away. A real app would poll
// waitForVerification while the user sends the SMS.
$cancelled = $client->cancelVerification($v->id);
printf("final status after cancel: %s\n", $cancelled->status->value);
