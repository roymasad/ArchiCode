<?php
namespace App\Service;
use App\Util\Log;
class Mailer { public function send() { Log::write('sent'); } }
