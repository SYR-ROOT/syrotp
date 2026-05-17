<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests\Support;

use Psr\Log\AbstractLogger;
use Stringable;

/**
 * Minimal PSR-3 logger that records every call so tests can assert
 * what the SDK logged.
 *
 * Each record is `['level' => string, 'message' => string,
 * 'context' => array<mixed>, 'rendered' => string]`. The rendered
 * field interpolates `{key}` placeholders with the context — that's
 * the same shape that lands in real log files, so canary substring
 * checks against `rendered` are trustworthy.
 */
final class RecordingLogger extends AbstractLogger
{
    /** @var list<array{level:string, message:string, context:array<mixed>, rendered:string}> */
    public array $records = [];

    /**
     * @param mixed $level
     * @param string|Stringable $message
     * @param array<mixed> $context
     */
    public function log($level, $message, array $context = []): void
    {
        $msg = (string) $message;
        $rendered = self::interpolate($msg, $context);
        $this->records[] = [
            'level' => (string) $level,
            'message' => $msg,
            'context' => $context,
            'rendered' => $rendered,
        ];
    }

    /** @return list<string> */
    public function rendered(): array
    {
        return array_map(static fn (array $r): string => $r['rendered'], $this->records);
    }

    /**
     * Replace `{key}` placeholders with their context values, scalar-coerced.
     *
     * @param array<mixed> $context
     */
    private static function interpolate(string $message, array $context): string
    {
        $replace = [];
        foreach ($context as $key => $value) {
            if (is_scalar($value) || $value === null || $value instanceof Stringable) {
                $replace['{' . (string) $key . '}'] = (string) $value;
            }
        }
        return strtr($message, $replace);
    }
}
