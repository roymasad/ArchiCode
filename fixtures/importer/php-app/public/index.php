<?php
require '../src/bootstrap.php';
use App\Service\Mailer;
(new Mailer())->send();
